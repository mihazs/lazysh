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

Open **Sessions** on an SSH connection. lazysh discovers tmux, rmux, Herdr and Zellij independently. Attaching opens a separate PTY on the verified SSH transport, preserving the original shell. Closing an attached terminal detaches that client; the remote multiplexer owns its processes.

## tmux

Select **tmux server** on an ordinary SSH connection and choose **Browse server**. `default` selects tmux's standard server; other names select the public `tmux -L NAME` socket-name interface. The selector is fixed on an attached terminal: its tree/actions and Jump To remain on the native attachment's server. Open another attachment from a plain SSH connection to choose another server. Names are literal 1–64 UTF-8-byte basenames: Unicode, spaces, apostrophes and shell-looking text are accepted; `/`, control characters, `.` and `..` are rejected. Socket paths (`-S`) are not accepted. Filesystem/socket-length failures remain explicit host diagnostics.

All tmux client invocations also select UTF-8 (`-u`), preserving literal metadata and tab-delimited discovery even when the remote login environment has no UTF-8 locale.

**Changed default:** every command explicitly uses `-L default` or its selected named server. Previously, bare tmux commands could inherit a different socket from the remote `TMUX` environment variable. Legacy workspaces without server metadata now consistently select the standard default server. Saved attachment intentions preserve the server plus exact human session name; Jump To changes the destination without dropping server identity. Native session context rejects conflicting action/tree requests, and the retained control channel never reconnects to a restarted server with reused IDs.

This follows documented [tmux named-server semantics](https://man.openbsd.org/tmux.1) and [upstream 3.4 socket-label construction](https://github.com/tmux/tmux/blob/3.4/tmux.c#L175-L219). The reference client help exposed `tmux:<server>`, but the exact private gateway meaning was not recovered. This is independent implementation from the public interface. Agent pane IDs alone do not establish server identity: transcript/approval identity remains explicit, and no pane-only routing is added. Notifications open their recorded existing native connection ID, never a first session-name match. Companion snapshots are host-wide: that connection is not proof of a matching agent pane/server, and this slice does not infer one. Desktop theme deep links do not attach multiplexers. Cold or warm saved-host CLI composition opens the exact requested tmux/Herdr picker through normal SSH authentication; see [launch usage](connections.md#multiplexer-picker-launches). Actual OS GUI acceptance remains tracked in issue #86.

The workspace tree lists real session, window and pane IDs, current commands, directories and active state. Create/rename sessions and windows, choose a project directory, select windows/panes, split panes and toggle zoom. Each pane row also shows its size in cells and its title, and has **Rename** (the pane title, `select-pane -T`), four **Move divider** arrows (`resize-pane -L|-R|-U|-D`, five cells each, clamped by tmux to what the layout allows) and **Close**; a session has **Close session**. Closing asks first, in a confirmation that names the pane (id, command and directory) or the session, and sends one `kill-pane` or `kill-session` by exact id only when confirmed; Cancel sends nothing. tmux reuses `$0` and `%0` after a server restart, so the tree read names its server instance (a random `@lazysh_server` option set once per server, `set-option -s -o`) and close, rename and resize carry that token back: each runs as `if-shell -F '#{==:#{@lazysh_server},<token>}' '<command>'` in one tmux invocation and fails with a "can't find pane" error on a replaced server instead of touching its same-numbered pane (#2044). A server that reports no token offers none of the four. Refresh reads current host state. A window closes from the [tab strip](#tab-strip). Pane close, rename and resize for Zellij, Herdr and rmux are tracked in [#1144](https://github.com/mihazs/lazysh/issues/1144). Actions use exact IDs instead of injecting prefix sequences into a foreground agent.

Choose a list, accordion or grid layout; the client remembers it. Load recent projects from the host companion's real agent history, ordered by most recent event, then select a directory in the launcher. The companion remains optional: you can always enter a directory manually.

Shell quoting alone does not protect tmux arguments: tmux parses trailing semicolons and expands format strings. lazysh separately escapes those layers to preserve literal names and directories. Control characters in names/paths are rejected because the discovery protocol is tab/line delimited. A response exceeding 1 MiB or 4096 panes fails explicitly.

### In-session Jump To

A tmux terminal attached through lazysh offers **Jump To** with its session/window
tree and an exact **Current** marker. Each window lists its panes, numbered like
tmux numbers them, with the pane's title (blank while it still has tmux's default,
the host name) or else its running command, the agent a companion report names in
that pane (matched by `TMUX_PANE`, like the Agent view and the status bar; a
session that ended names none) and **Zoomed** on the active pane of a zoomed window.
Exactly one row carries the Current marker: the displayed pane, not also its window.
Choosing Current closes the panel without sending a command. List, accordion and
grid share the existing saved layout preference. A successful switch remembers the
destination's human session name; numeric IDs and navigation generations are never
saved for reconnect.

Choosing a pane row moves the retained control client's display to that exact pane:
one `switch-client` to `session:window.pane`, on the server the terminal is attached
to, after a fresh read confirms the pane is still in that window. A pane that closed
or moved since the list was read is refused with a message and leaves the display and
the binding as they were; **Refresh** reads the tree again. Like `select-pane`, it
brings the pane's window forward and, in a zoomed window, un-zooms it so the pane
shows. Pane titles and commands are program-controlled: control characters show as
`?` and each is cut to 64 columns before it reaches the client. The tree has one row
per pane, so the 4096-row limit below counts panes: a host with more panes than that
fails Jump To explicitly instead of listing a part of them. A binding that sends no
`panes` keeps the window-only tree. An agent label is matched by pane id alone, so two
tmux servers on one host that both run an agent in `%7` can show the same label; the
companion's server label (#1146) is not used by this panel yet.

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
restarted server with reused IDs. Plain shells and externally attached/unbound
terminals do not gain this tmux tree. A Zellij terminal has its own Jump To, described under [Zellij](#zellij). An absent or malformed handshake
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

List running named servers, then attach or browse one. The Herdr tree preserves server/workspace/tab/pane identity and displays reported agent states. Create and rename workspaces/tabs, focus workspaces/tabs, split and zoom exact panes, and focus reported agents. Each pane row also shows the pane's label (its `pane rename` name) and has **Rename** (`pane rename`), four **Move divider** arrows (`pane resize --direction left|right|up|down`, five percentage points of the split per press; Herdr clamps it to what the layout allows) and **Close** (`pane close`); each workspace has **Close Herdr workspace** (`workspace close`). Closing asks first, in a confirmation that names the pane (id, label and directory) or the workspace and says that its programs stop (closing a tab's last pane closes the tab), and sends one command by exact id only when confirmed; Cancel sends nothing. A primary workspace that still has linked worktree workspaces is refused by Herdr (`workspace_group_close_required`); lazysh never adds `--group`, shows "close those first" in the selected language and keeps the confirmation open. A pane label of exactly `--clear` is refused because Herdr reads it as "remove the label". On a Herdr version outside 0.9.3 to 0.9.5 the panel stays navigation-only, so none of these controls appear. Plain panes can be selected through the terminal; Herdr's `agent focus` command only accepts agent panes.

The integration uses the [public Herdr CLI/socket snapshot contract](https://herdr.dev/docs/socket-api/) and validates its response shape and exact IDs. Incompatible response shapes fail explicitly. lazysh does not install the system Herdr, alter its configuration, or stop existing servers. The one exception is the optional managed Herdr, which only an explicit action installs or removes: see [Managed Herdr install and removal](herdr-managed-install.md).

### Which Herdr a connection runs

A connection runs one Herdr, chosen once: the host's own `herdr` (the default) or the optional managed derivative built from `packages/herdr-upstream` with the `lazysh-managed` feature (its own `lazysh-herdr` namespace, see [its provenance](../packages/herdr-upstream/PROVENANCE.md)). The choice is the closed name `system` or `managed`, never a path or a command: `herdr_backend_select` takes it for a connection, and an `attach_multiplexer` call or a Mosh entry can carry it as `backend` so that a restored entry names the Herdr it ran on.

The first Herdr use on a connection captures the choice; a first use that names none captures the host's own Herdr. A later, different choice fails with `herdr_backend_captured` and is never re-resolved, and a reconnect is a new connection that chooses again. Everything on the connection then runs that Herdr: discovery, the session list, the tree and its actions, workspace creation, SSH and Mosh attachment, the guard's capability check and its RPCs, and the actor that owns the attached display. Exact pane focus runs the companion with the chosen Herdr first on `PATH`, so it reads that Herdr's sessions. A guarded attachment whose startup fails is closed and never retried as the other Herdr or as an ordinary attach. A local session always runs the host's own Herdr.

The managed Herdr is the single file `~/.local/libexec/lazysh-herdr/herdr`. It must be an executable regular file that only you (or root) can replace, below directories that only you (or root) can change, and no part of the path may be a symbolic link: the same check as for the official installer's `~/.local/bin` fallback. If that fails, or the host is not a positively identified Linux or macOS host, the call fails, discovery reports Herdr as absent, and nothing falls back to the host's own Herdr. Nothing installs the managed file yet and the app offers no choice: the explicit install and remove (#1760) and the release asset (#1522) are later slices, so no release or platform support is claimed.

Supported Herdr versions are **0.9.3 through 0.9.5**. CI builds stock and guarded Herdr 0.9.5 from the pinned source and runs the native and Android Herdr suites against them. lazysh uses only commands, exact IDs, snapshot fields and error codes that 0.9.3 and 0.9.5 share, so hosts still on 0.9.3 keep working. What changed in Herdr 0.9.4 and 0.9.5:

- If a workspace, tab or pane was closed on the host after the tree loaded, Herdr answers `workspace_not_found`, `tab_not_found`, `pane_not_found` or `agent_not_found`. lazysh shows "The selected connection or destination changed" instead of Herdr's raw JSON. Exact pane navigation goes through the companion, which reports `pane_not_found` as `HerdrFocusMissing`; an older companion still shows its generic failure. Since 0.9.4, an out-of-range workspace number also returns `workspace_not_found` instead of crashing the server.
- Since 0.9.4, closing the shell that started Herdr no longer stops the server on Linux and macOS. Stop a server with `herdr server stop` or SIGTERM, not SIGHUP. lazysh never stops servers, and its test fixtures use `server stop`, SIGTERM or SIGKILL.
- Herdr 0.9.4 asks before closing a workspace's only pane from its own keys or menu (`ui.confirm_close`). lazysh asks for its own confirmation before every close it sends, and CLI/API closes stay immediate.
- Herdr 0.9.5 reads Codex status from the screen again instead of turn hooks. lazysh shows whatever state Herdr reports.

Agents initially reads the attached Herdr session when discovery lists that exact
name, including when several servers are running. Choosing another server overrides
that initial selection. If the attached session is absent, choose a server explicitly;
lazysh does not substitute another one. Plain terminals automatically select a sole
running server and require a choice when several are available. Discovery reads one
server per refresh and does not grant terminal input or approval authority.

The **Spaces** tree marks the current workspace, tab and pane. Stock Herdr has no
read for where one client is looking: its snapshot reports the server's shared
focus, which another connection may have moved, so that is what the marker shows
and why choosing a row says it changes focus for other connections. On the
optional guarded Herdr host, the client attached through this terminal reports
its own workspace, tab and pane through `lazysh.guard.observe`, and the marker
shows that location instead, but only when the report names the server Spaces
is reading. While a Chat turn holds the guard, the last reading stays; when the
guard is unavailable the marker returns to the shared focus. Real acceptance on
a phone and a guarded host with two clients is not part of this change.

### Live updates and the inbox

While a Herdr view (Spaces, Agents, the tab strip or the Agent view) is shown, lazysh reads the server's changes from the host companion's `herdr-events` stream ([Herdr event stream](companion.md#herdr-event-stream)) instead of reading the tree every 5 seconds. A workspace, tab or pane that was created, closed, moved, renamed or focused, and an agent whose status changed, make one read of the tree about a quarter of a second later; a slow read every minute stays as a net under a missed event. Spaces and Agents say which mode they are in: **Live: Herdr's changes appear as they happen.**, or a note that live updates are unavailable and the view refreshes every 5 seconds. The note covers the cases below, and the view keeps working in each:

| Host | What the view does |
| --- | --- |
| Companion and Herdr stream | Live. A lost stream shows the polling note at once and reopens after 1, 2, 5, 10 and then 30 seconds. |
| A companion that predates `herdr-events` | The "newer host companion" note, and a new try every minute. |
| A Herdr that refuses `session.snapshot` or `events.subscribe`, or has more than 256 panes | The same note, and a new try every minute. |
| The channel cannot open (too many live views, a lost connection) | The polling note and the 5-second read. |

One stream serves every view of that server on that connection, and the inbox when it follows that server. The views close it with the last view and while the app is in the background; the inbox keeps it open (see below).

With **Monitor connected hosts** on in the [inbox](notifications.md), an agent that becomes **blocked** in a Herdr pane becomes an inbox event in **Needs you**, and one that becomes **done** is listed in **Done**; a blocked agent also raises the system notification. The row carries the agent, the pane's directory and the Herdr pane (`herdr:<server>:<pane id>`), never the command, the pane title or any screen text. When Herdr names the agent's session (Claude Code, Codex and OpenCode), the row is the same one the companion's hooks report, and a hook report of the same state within a minute is not a second alert, in either order. An agent without a session id is matched by its pane and kind. A tap on the row opens its session, not yet the pane ([#1690](https://github.com/mihazs/lazysh/issues/1690)).

No Herdr view has to be shown. While monitoring is on, each poll of the inbox (every 15 seconds) also asks a connected host which Herdr servers it runs and keeps one stream open to the server of the attached terminal when that server runs, or to the only running one. A host with several servers and no attached one is not followed; a host without Herdr, or with a companion that predates `herdr-events`, keeps the hook reports and the poll as before. It is the stream a Herdr view of that server on that connection reads, so the two never open two. It closes when monitoring is turned off or the host disconnects, whatever the view does, and the app in the background keeps it as it keeps the poll. A blocked or finished pane is read once from the host's tree to learn which agent session it holds, so its row is the hook's row and not a second one; that adds one read to each blocked or done event. The extra requests stay inside the poll's limits (32 hosts, four requests in flight), and a lost stream reopens as it does for a view. The app holds up to 32 event streams, one per connection and Herdr server, counted apart from the four conversation streams of the Agent view, so following many hosts neither takes those four nor is refused by them.

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
input. A dialog answer (an option's digit, arrows and Enter) goes through `herdr agent send-keys PANE KEY...` on either kind of host, after the same check of the pane's agent session, and the dialog itself is read with `herdr agent read PANE --source visible`; see [Herdr panes](agent-view.md#herdr-panes).

Herdr **Spaces** has a **Jump To layout** control above the workspace tree with the
same three layouts and the same remembered preference as tmux Jump To
(`lazysh.multiplexer.layout`):

- **List** (the default) shows every space open.
- **Accordion** opens only the focused space. Any space can still be opened or
  closed by hand until the layout changes.
- **Grid** sets the spaces side by side as cards when the sidebar is wide enough for
  two.

The layout only changes how the tree is drawn: a space, tab or pane row always sends
the same exact target, and searching opens every matching space in any layout.

### Pane input on a stock Herdr, pinned to one server process

`lazysh-agent herdr-pane-input --session NAME` is the host half of typing into a
named pane of an unchanged stock Herdr (Linux hosts with kernel 6.5 or newer; on
other hosts it reports `HerdrInputPlatformUnsupported` and nothing is sent). It
speaks JSON lines on stdin and stdout and ends when stdin closes. The app does
not use it yet, so no Chat or Agent view behaviour changes in this release; it is
the verified transport that the explicit destination picker will build on (#655).

Stock Herdr has no private guard to prove which server owns a socket, and its
JSON connections last one request. The actor therefore pins the server process
once: it connects, takes the peer's pidfd from that connection (`SO_PEERPIDFD`,
never a pid number reopened later), checks the peer belongs to the same user, and
keeps a read-only `events.subscribe` connection open. Each operation then opens its
own connection and compares that connection's peer, by pidfd, pid and process start
time, with the pinned process before a single request byte is written. Anything
else retires the actor for good, with no rediscovery and no retry: a socket path
now served by another server, a restarted server, the subscription ending, the
server process exiting, a kernel without `SO_PEERPIDFD`, or a malformed request.

Requests are `preflight` (read the pane's occupant: pane id, terminal id, agent,
working directory, label, title), `send` (text plus Enter in one `pane.send_input`)
and `escape`. Text is 1 to 4,096 bytes of UTF-8 without control characters other
than newline and tab, the same bound as guarded Herdr input; Herdr itself wraps it
in bracketed paste when the pane's program asked for that. Operation ids must
strictly increase and are spent before anything is sent, so a repeated id cannot
write twice. Outcomes are `occupant`, `delivered`, `refused` (Herdr or the actor
said no before writing: stale id, invalid text, pane not found, the occupant changed,
Herdr's own error reply), `retired` (the pinned server is gone; nothing was written)
and `uncertain` (the request left and no intact acknowledgement came back; it is
never resent). `retired` and `uncertain` end the actor, so the caller must confirm a
destination again and keeps its draft.

The destination is the selected pane's **current occupant**. Herdr's public API has
no terminal-id or revision compare-and-swap, so the actor reads the pane right
before writing and refuses when its terminal id is no longer the confirmed one, but
a runtime replaced in the instant between that read and the write is the one window
this cannot close. It does not focus, resize, attach or resume anything, so another
client's focus cannot redirect the input and sending moves no client.

What is verified: the CI `native-linux` job runs
`herdr_pane_input_stock` against the same-run unchanged stock Herdr and owned PTY
receivers: the selected receiver gets the exact bytes in legacy, bracketed-paste and
Kitty keyboard modes (a 4,096-byte UTF-8 draft included, Escape as `ESC` or
`CSI 27 u`) while the others stay empty, a focused other pane gets nothing, a pane
closed after the preflight is refused, a socket path taken over by another live
server and a restarted server are retired before any request byte, and a lost
acknowledgement is `uncertain`. What is not: a server that hands its listener to a
new process (`server.live_handoff`) is retired, because the pinned process exits;
PID reuse, inherited listeners and PID namespaces were not induced; macOS and
Windows hosts are unsupported; and the Android and desktop confirmation screens are
not built yet.

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

Both dialogs ask **Start an agent in it?** and default to not starting one; the Agent
view's empty state opens the worktree dialog with the answer already yes (**Start in a
new worktree**).
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

## rmux

[rmux](https://github.com/Helvesec/rmux) (MIT OR Apache-2.0) reimplements tmux's commands, flags and formats in Rust. lazysh drives it through the same stack as tmux, so it is covered by the [tmux](#tmux) section: `rmux -u -L NAME` replaces `tmux -u -L NAME`, server labels follow the same literal rules and are never socket paths, and the tree, session, window and pane actions, attach, numbered-window and prefix shortcuts, saved workspace restore, desktop `--mux rmux[:NAME]` launch and Mosh entry all reuse tmux's command builders. lazysh always runs `rmux` by name, never a `tmux` shim, and does not use rmux's SDK or wire protocol.

In **Sessions**, **Browse rmux sessions** switches the server selector from tmux to rmux; the status line lists rmux next to tmux, Herdr and Zellij. Discovery admits rmux from `rmux capabilities --json` (binary contract 1, wire version 8 and control mode), never from `rmux -V`, which prints tmux branding. Every rmux discovery command runs with `-N`, so probing a host never starts a daemon. If the running daemon refuses this rmux's protocol after an upgrade, rmux is shown as **Unsupported** with "Restart the rmux daemon after upgrading."; a build that does not report those capabilities is also shown as unsupported and is not offered. An rmux session is not found for another family's server label, and a terminal attached to rmux keeps its own labelled server for tree and actions.

**Limited:** rmux 0.10.x is shown as **Limited** until its Jump To control client and confirmed Chat input are verified on a real rmux. An rmux terminal opens as a terminal with window and pane actions; Jump To, the tab strip and Chat input stay hidden for it, and the Agent view uses **Stage in terminal**. rmux's daemon keeps its sessions in memory, so a saved workspace reattaches only while the session still exists after a reconnect or an app restart; a daemon or host restart ends it, and restore fails the way it does for a vanished tmux session. A newly created session is still created by choosing **New session**. rmux is reached over SSH only: a terminal on this machine refuses it with "rmux sessions in local terminals are not available yet" (#1148).

rmux 0.10.0 stores session, window and pane names as typed, but may expand formats in a start directory (`-c`). lazysh wraps the path in a literal format and escapes its delimiters, so sessions, windows and split panes start in the requested directory even when it contains format or style markers. The implementation is tested against rmux 0.10.0 and preserves tmux's existing quoting.

The `native-linux-runtimes` CI job installs the checksum-verified rmux 0.10.0 release with its own installer, so `bin/`, `libexec/` and the daemon stay together, and `bun run test:multiplexers` then runs `real_rmux_lifecycle_and_literal_names`: product discovery plus every typed action with names containing quotes, `$(…)`, `#(…)` and a trailing `;`, and a new session, window and split pane in start directories named `it's #{x};`, `w#{pane_id}#(echo hi)##b`, `no#(echo hi)##format`, and `style#[b]#{literal}## and } trailing ` (each pane's `pane_current_path` is the directory chosen), with the parsed tree equal to `rmux list-panes -a`. Two further cases run over owned OpenSSH: `real_ssh_discovery_reports_multiplexer_versions_and_support` (rmux 0.10.0 is reported through product discovery) and `real_ssh_rmux_discovers_attaches_and_acts_on_a_labelled_server` (no daemon or socket after a probe, create and tree on a labelled server, attach and terminal output, actions on the bound server, refusal of another family or label, and the durable session after the tab closes). Windows and macOS clients, Android and a real Mosh entry are not yet exercised against rmux.

## Zellij

List running sessions or enter a name to create/attach one. The list names live sessions and exited ones (Zellij keeps a resurrectable layout, and attaching resurrects it); a host with Zellij and no session shows "No running zellij sessions." instead of an error, although Zellij itself exits with status 1 there. Its shortcut panel creates named tabs in a project directory, selects numbered tabs, moves between tabs, splits the focused pane and toggles fullscreen. The **Directory** field applies to new tabs and to **Split right** and **Split down**: a split in a directory other than the default `.` runs your shell (`$SHELL`, else `sh`) in a pane that closes when the shell exits, because Zellij 0.45.1 and 0.46.0 ignore `--cwd` for a plain terminal pane; the default `.` opens a plain pane in the session's own directory. Commands target the selected named session; focused-pane actions follow that session's current focus. A Zellij terminal also offers **Jump To**, below.

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
not establish current tabs, exact-client binding, or physical
device/runtime acceptance. Hiding/persisting this row remains separate work.

### Panes and sessions

On a Zellij the version gate calls supported (0.45.1), the Zellij panel also renames and closes the session and reads, renames, resizes and closes its panes. **Read Zellij panes** runs `zellij action list-panes --json --all` (`zellij_panes`) and lists each terminal pane with its number, running command, tab, size in columns and rows and title; plugin panes such as the bars are not listed. Every pane action addresses the pane by its number, never the focused one, through the typed `zellij_action`:

| Action | Command |
| --- | --- |
| Rename pane | `zellij --session=<S> action rename-pane --pane-id terminal_<N> -- <name>` |
| Move a divider | `zellij --session=<S> action resize increase <left\|right\|up\|down> --pane-id terminal_<N>`; Zellij resizes by a fixed step and has no cell count, so `amount` repeats the step (the panel sends one) |
| Close pane | `zellij --session=<S> action close-pane --pane-id terminal_<N>` |
| Rename session | `zellij --session=<S> action rename-session -- <name>` |
| Close session | `zellij delete-session --force -- <S>` |

Close asks first, in a confirmation that names the pane or the session and says that programs running in it will end, and sends one typed action only on **Confirm close**; Cancel sends nothing. A pane that went since the list was read is not guessed at: Zellij ignores its number. Names reach Zellij as one quoted word after `--`, so a name that starts with a dash or holds `'`, `$(…)` or `;` stays a name. After a pane action the list that is on screen is read again; after a session rename the session list and the open panel follow the new name, and after a close they drop the session. **Rename Zellij session** is not offered for the session this terminal is attached to, because the saved attachment (and a reconnect) would keep asking for the old name; rename it from a terminal that is not attached to it.

Close session uses `delete-session --force`, not `kill-session`: `kill-session` stops a session but, once Zellij has serialized it (about a minute after it was created), keeps listing it as EXITED so it comes back in the session list and `attach` resurrects it. `delete-session --force` stops a running session and removes that record too.

These actions show only where the capability record allows them: on a Zellij other than 0.45.1 the record lists `rename`, `close` and `resize` as missing, and the panel shows neither the pane list nor the session actions.

The [public Zellij commands](https://zellij.dev/documentation/commands) were verified against **0.45.1**. Session names beginning with a dash are rejected: Zellij's attach CLI uses `--` for an initial command rather than to disambiguate that positional name.

## Launch an agent in a tmux or rmux window or a Zellij pane

`multiplexer_launch_plan` and `multiplexer_launch` (the commands behind the launcher of
[#1128](https://github.com/mihazs/lazysh/issues/1128)) generalise the Herdr creation plan above:
the same agent table, the same `command -v` check and the same literal argv, started in the
session a terminal is attached to. They take the connection's typed multiplexer entry (kind,
session name and, for tmux and rmux, the server label), never a command string, and refuse an entry
that asks to create the session. The renderer shows `multiplexer_launch_plan` first and runs
`multiplexer_launch` only after the user confirmed it.

```sh
command -v -- <agent>                                                    # missing agent: nothing is created
git -C <repository> worktree add -b <branch> -- <path> <base>            # worktree only
tmux -u -L <server> new-window -d -P -F '#{pane_id}' -t =<session>: -n <label> -c <directory> -- <agent> [<prompt>]
zellij --session=<session> run --cwd=<directory> --name=<label> -- <agent> [<prompt>]
```

rmux is a tmux-family kind ([#1140](https://github.com/mihazs/lazysh/issues/1140)), so it takes the tmux
line with `rmux` in place of `tmux`: `rmux -u -L <server> new-window -d -P -F '#{pane_id}' …`, with the
server label of the entry (or `default`) and the same `new-window` words.

The agent is the executable's own argv, `<agent> [<prompt>]`, so nothing is parsed by a shell:
tmux and Zellij both `exec` it directly. A prompt may hold quotes, `$(…)`, backticks, tabs and
line breaks and reaches the agent byte for byte. Only the codex and claude entries of the table take
an initial prompt; the prompt cannot start with `-`, contain a backslash or other control
characters, or exceed 2000 bytes. (Herdr's `agent start` still takes one line.) tmux parses an
argument that ends in `;` as a command separator and expands formats in window names and
directories, so those layers are escaped separately from the shell's (`\;`, `##`). rmux 0.10.0 stores a
window name as typed (no `##`) and takes a start directory as a literal format (`#{l:…}`, with its `#` and `}` escaped).
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
session, splitting an existing pane instead of opening a window and a Zellij tab are not part of this
primitive yet, and no screen calls it yet.

### Zellij Jump To

On Zellij 0.45.1 (the version gate's `tree` capability; 0.44.x and others show no Jump To) a terminal attached to a Zellij session offers **Jump To** with that session's tabs, numbered from 1 like the tab strip. The list reads `zellij --session S action list-tabs --json` and `list-clients` (`zellij_jump_tabs`); a tab without a stable id is not listed. Host names are shown as text.

Zellij cannot address a client from the command line: `go-to-tab-by-id` carries no client id and acts on whichever client the server picks, and with two clients on different tabs `list-tabs` marks both tabs active (#2046, reproduced on Zellij 0.45.1 and 0.46.0). So Jump To claims a current tab and jumps only while this terminal is the one attached client. Then exactly one row is **Current** (`aria-current="location"`), choosing it closes the panel without a command, and choosing another tab runs `zellij --session S action go-to-tab-by-id <id>` through the typed `zellij_action` `jump`, which counts the clients again first and fails with `zellij_client_ambiguous` unless there is exactly one. With another client attached the tabs are listed without a Current row, their buttons are disabled and the panel says why. A client that attaches between that count and the jump can still be moved: Zellij offers nothing atomic. A pane is not a destination: Zellij's `focus-pane-id` leaves the attached client where it was.

Checked by Vitest (`zellijJump.test.ts`, `TmuxJumpPanel.test.tsx`), the Rust unit tests of `zellij.rs`, and Playwright `e2e/zellij-jump.spec.ts` on phone and desktop (one current row and a jump by tab id, a shared session without a current row or jump, no Jump To on a version without the capability).

## Tab strip

An attached tmux, Herdr or Zellij terminal shows its tabs in one native row above the terminal (`MultiplexerTabStrip`). One backend-agnostic model feeds it (`multiplexerTabs.ts`: title, active, needs attention, agent state, and the guarded command a chip runs), read by `useMultiplexerStrip`:

| Multiplexer | Reads | Leading chip | Chip tap runs |
| --- | --- | --- | --- |
| Herdr | `useHerdrNavigation` (`herdr_tree`, read when the host's event stream reports a change and every 5 s while the terminal is shown without one) | The focused workspace; opens the list of workspaces, each with its agent state, and flags another workspace that needs attention | A fresh `herdr_tree`, then `herdr_action` `focusTab` / `focusWorkspace` only if the target still exists |
| Zellij | `zellij_tabs` (`zellij action list-tabs --json`, Zellij 0.45 or newer; every 5 s) | The session name | `zellij_action` `goToTab` with the 1-based position |
| tmux | The Jump To snapshot of the attached control stream (every 5 s) | The session name | `tmux_jump` with the snapshot's generation, so a stale list is refused |

A selection is never typed into the terminal, never focuses an input (the soft keyboard stays as it was) and never resizes the terminal beyond the strip's own row. Chips are buttons in a labelled group, not `role="tab"`: session tabs are the workspace's only tabs. **Preferences > Keyboard and gestures > Show tab strip** (device-local): **Auto** shows the strip on phones when the session has more than one tab (Herdr: more than one tab or workspace) and the key toolbar is shown; **Always** shows it whenever the terminal is attached, on any screen; **Never** removes it and stops the reads. A multiplexer that cannot list its tabs (an older Zellij, a tmux terminal without the control stream) shows no strip. Not in this version: closing a workspace, a session or a pane from the strip, and the Herdr panes level.

### New tab, rename and close

The strip also changes tabs, only through the multiplexer's existing typed commands and only where the command layer has them:

| Multiplexer | **+** (end of the row) runs | Long press, right click or the context-menu key offers |
| --- | --- | --- |
| Herdr | `herdr_action` `createTab` in the focused workspace, starting in the directory of that workspace's first reported pane (`.` when none is reported); the new tab is then focused | `renameTab` and `closeTab` (`herdr tab close`) on a tab; `renameWorkspace` on a workspace of the leading chip's list |
| Zellij | `zellij_action` `newTab` (Zellij focuses the new tab itself) | `renameTab` (`rename-tab-by-id`) and `closeTab` (`close-tab-by-id`), by the stable `tab_id` that `list-tabs --json` reports, never by position; a Zellij that reports no `tab_id` can select a tab but not rename or close it |
| tmux | `tmux_action` `createWindow` in the attached session, on the attached tmux server; the new window is then selected with `tmux_jump` | `renameWindow` and `closeWindow` (`kill-window`), by the window's `@` id |

A long press on a tab with both actions opens a two-item menu (**Rename**, **Close**) that drops from the strip like the workspace list; with only one of them it goes straight to it. **Close** asks first, in a confirmation that names the tab and says that programs running in it will end, and sends one typed command by the tab's exact id only on **Close**; Cancel, Escape or a press elsewhere sends nothing. The only tab of a Herdr workspace, a Zellij session or a tmux session is never offered for closing, so the strip cannot close the session's last tab. After a rename or close the strip rereads at once instead of waiting for the next 5 s read. The menu items and the confirmation are 44 px targets, drop over the terminal without resizing it and never open the soft keyboard: moving focus into them is for keyboard users only.

The **+** and **Rename** drop a small prompt over the terminal (it takes no layout space): a name, and for a new tab a directory (`.` is the shell's own start directory, as in the Spaces and tmux panels). The prompt is the one thing in the strip that opens the soft keyboard, on purpose, because the user is typing a name. A Herdr workspace or tab that has gone since the strip last read is refused, as a focus is, never renamed or closed by guess. A failed command is reported and keeps the prompt open. A half-typed name ends only with Escape, Cancel or Save, so a stray tap on the terminal does not lose it. The long press is 0.5 s without moving more than 10 px; the tap that ends it does not also select the chip.


## Clipboard (OSC 52)

Text copied inside a multiplexer reaches the device clipboard as an OSC 52 write. The terminal pane turns it into a **Remote clipboard request** that shows the text, and nothing touches the clipboard until you choose **Allow this copy**. Requests are write-only and bounded to 64 KiB, a read request (`?`) is ignored, and a request for the primary selection (`p`) is ignored. The clipboard letters `c` and `s`, or no letter, are accepted. The DCS-wrapped forms that tmux and GNU screen use for passthrough reach the same prompt. These rules belong to the pane, so they are the same for every multiplexer. What differs is whether the multiplexer sends the copy to your terminal at all:

| Multiplexer | Option on the host | Notes |
| --- | --- | --- |
| tmux | `set -g set-clipboard on`, and `set -g allow-passthrough on` (tmux 3.3 or newer) for programs that send OSC 52 wrapped for passthrough | The default, `set-clipboard external`, already forwarded a copy-mode copy to an `xterm-256color` client in a local check with tmux 3.8, and `off` blocked it. It needs the client's `TERM` to advertise the clipboard. For another `TERM`, add `set -as terminal-features ',TERM:clipboard'`. `on` additionally accepts a program's plain OSC 52 into tmux's buffer. The browser cases set `set-clipboard on` and `allow-passthrough on` (plus an `Ms` override for terminfo entries without the clipboard capability). |
| Zellij | None | With no `copy_command`, Zellij copies through OSC 52, and `copy_on_select true` (the default) copies when you release the mouse button. Leave `copy_clipboard` at `system`: `primary` sends the `p` selection, which lazysh ignores. A `copy_command` such as `wl-copy` sends the copy to a clipboard tool on the host instead. Programs in panes can write OSC 52; `dangerously_enable_paste_buffer_read` stays off and lazysh never answers a read request. |
| Herdr | None over SSH | Herdr writes OSC 52 when `SSH_CONNECTION`, `SSH_TTY` or `VSCODE_IPC_HOOK_CLI` is set (sshd sets the first two), under WSL, and whenever no native clipboard tool (`wl-copy` under Wayland, `xclip` or `xsel` under X11) can take the copy. `[ui] copy_on_select = true` (the default) copies when you release the mouse button. A Herdr started locally on a desktop with a working native tool writes that desktop's clipboard and sends no OSC 52. |
| rmux | Not available | rmux is not supported yet ([#1140](https://github.com/mihazs/lazysh/issues/1140)). |

tmux copies with its keyboard copy mode (Copy mode, then search, select and Enter); Zellij and Herdr copy with a mouse selection. The browser cases in `apps/client/e2e/tmux-clipboard.spec.ts` and `apps/client/e2e/multiplexer-clipboard.spec.ts` start each real multiplexer with exactly the options in this table, show its client in the terminal pane and assert that the consent prompt shows the copied text, that the clipboard still holds the old text until **Allow this copy**, and that Allow writes the exact text. For each multiplexer one case copies a selection and another has a program in a pane write OSC 52. The Zellij and Herdr cases select with SGR mouse reports written to the client, not with a touch gesture, so they run in the `desktop` project only. The Windows client has no real-multiplexer job ([#1747](https://github.com/mihazs/lazysh/issues/1747)); its job runs the unit tests of the handler itself (`bun run --cwd apps/client test:osc52`).

## Supported versions and degraded capabilities

The Sessions panel shows each multiplexer's version and a **Supported** or **Limited** badge. A Limited multiplexer keeps ordinary terminal access; the capabilities it lacks are not offered, and a notice names the version that adds them. One Rust table (`multiplexer.rs`, `tool`) maps the version to the badge; the frontend never decides from the version string.

| Multiplexer | Version read from | Supported | Otherwise (Limited) | Notice | CI pins |
| --- | --- | --- | --- | --- | --- |
| tmux | `tmux -V` | 3.4 or newer (a patch letter is accepted, and `next-3.6` development builds count as 3.6) | No Jump To and no confirmed Chat input | "Jump To and Chat input need tmux 3.4 or newer." | 3.2a (distribution; the degraded case), 3.4 (source, sha256) and 3.8, the newest (source, sha256) |
| Zellij | `zellij --version` | 0.45.1 only | No workspace tree, rename, close, resize, agent launch or confirmed input | "The workspace tree, rename, close, resize and agent launch need Zellij 0.45.1." | 0.45.1 (release asset, sha256) |
| Herdr | `herdr --version` | 0.9.3 to 0.9.5 | Navigation only: no create, launch, rename, confirmed input or restore | "Only navigation is available. Full support needs Herdr 0.9.3 to 0.9.5." | Stock and guarded 0.9.5 built from the pinned source; 0.9.3 runs locally |
| rmux | `rmux capabilities --json` (not `-V`, which prints rmux branding) | Not available in a released client | Not available | Not available | Not available |

rmux ([Helvesec/rmux](https://github.com/Helvesec/rmux), a Rust reimplementation of tmux that keeps its flags and targets) is not supported by any released lazysh. Its first slice is tracked in [#1140](https://github.com/mihazs/lazysh/issues/1140); until a release says otherwise, treat rmux as unsupported. The target behaviour, including the 0.10.x range and the "Restart the rmux daemon after upgrading" notice, is in the [compatibility spec](multiplexer-compatibility.md).

Herdr support is decided by the version string alone: the Herdr API `schema_version` is not checked yet ([#1159](https://github.com/mihazs/lazysh/issues/1159)). Restoring sessions after a host reboot is out of scope for every multiplexer.

What each multiplexer does on each client platform, with the CI job and test that prove it, is in the [multiplexer capability checklist](reference/parity-matrix.md#multiplexer-capability-checklist). On Windows, the unit tests cover the version table, command building and tree parsing, and the `native-windows-linux-host` job runs a Windows client against a real tmux, Zellij and Herdr on a Linux host ([how](#a-windows-client-against-a-linux-host), [#1747](https://github.com/mihazs/lazysh/issues/1747)).

## History

The **Pane history** section of the Sessions panel (`MultiplexerHistory`) reads the scrollback of the pane you are viewing from the multiplexer on the host, not from the terminal's own buffer, so it survives a dropped connection, a reattach and a fresh client. It is shown for the attached tmux, Zellij or Herdr session unless discovery lists `history` as missing for that multiplexer's version. **Read history** (then **Refresh**) runs the one command `multiplexer_history` and shows the text read-only, with a line filter (**Search history**, case-insensitive) and **Copy these lines** for what is shown. Nothing is typed into the terminal.

| Multiplexer | Host command | Pane | Bound |
| --- | --- | --- | --- |
| tmux | `capture-pane -p -J -S -20000 -t =<session>:` on the attached tmux server | The active pane of the session's current window; wrapped lines are joined | The newest 20,000 lines |
| Zellij | `zellij --session=<session> action dump-screen --full` | The focused pane | Zellij's own `scroll_buffer_size` (default 10,000 lines); a dump over 8 MiB fails with `output_too_large` |
| Herdr | `herdr --session <session> pane read <pane> --source recent-unwrapped --lines 1000`, where the pane is the focused one in a fresh `api snapshot` | The focused pane | Herdr serves at most the newest 1,000 lines of a pane and does not report that it cut, so a read that fills 1,000 lines is shown as cut |

The view keeps at most the newest 20,000 lines and 2 MiB; when anything older was left out it says so. Control characters are removed from the text, and the blank rows of the screen below the cursor are trimmed. Zellij needs 0.45 or newer (`dump-screen --path`, stdout when omitted) and Herdr 0.9.3 to 0.9.5; other versions list `history` as missing and do not offer the section. The pane is resolved when you press **Read history**, so it follows the multiplexer's focus at that moment. History of a pane that is not the current one, a rmux pane and the OSC 52 checks of #1147 are separate slices.


## Native checks

With tmux, rmux, Herdr and Zellij installed on PATH:

```sh
bun run test:multiplexers
```

The `native-linux-runtimes` CI job runs this with Ubuntu's tmux, the same-run stock Herdr build, the checksum-verified official Zellij 0.45.1 release and the checksum-verified rmux 0.10.0 release. The Zellij case waits for the attached client's first render before it probes `list-sessions`: Zellij 0.45.1's server panics when a probe disconnects before its first client has created the session, and each later action is observed until its tab or pane state appears, because Zellij applies CLI actions asynchronously.

The OSC 52 copy cases ([Clipboard](#clipboard-osc-52)) run in Chromium against real clients. `native-linux-runtimes` runs them with Ubuntu's tmux, the checksum-verified Zellij 0.45.1 and the same-run stock Herdr. Locally:

```sh
LAZYSH_TEST_ZELLIJ=/path/to/zellij LAZYSH_TEST_HERDR=/path/to/herdr bun run --cwd apps/client test:e2e:multiplexers
```

Each case runs a private multiplexer server and client in a temporary directory, with every `HERDR_`, `ZELLIJ` and `TMUX` variable removed, so it never reaches a live session. A Zellij or Herdr case is skipped when its variable is unset (the `client` job installs only tmux) and tmux's is skipped without `tmux` and util-linux `script`, unless `CI` is set, where a missing binary fails.

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

The launch cases (`herdr_create::tests::real_tmux_agent_window`, `real_rmux_agent_window` and
`real_zellij_agent_pane`) run the confirmed plans through the same `sh -c` command strings against
a private tmux server, a private rmux daemon and a private background Zellij session, with a stub `codex` on the server's `PATH` that records
its directory and argv. They launch into a directory whose name holds `'`, `$(…)`, `#{…}` and a
trailing `;` and into a new worktree with a hostile branch name, and assert that the pane exists
in the directory (or worktree) `list-panes` reports, that the stub's argv is the prompt
byte for byte (quotes, `$(…)`, a line break and a trailing `;`), that `git worktree list`
shows the worktree, and that a missing agent or a missing session creates no pane, worktree or
branch. Zellij runs against the pinned 0.45.1; the same case also passed on 0.46.0. The rmux case
runs against the pinned, checksum-verified rmux 0.10.0 release that `native-linux-runtimes` installs
(a start directory with `#{…}` in its name reaches the pane only through the rmux-specific escaping). The plan builders have platform-neutral unit tests that also run on macOS and
Windows.

These Cargo tests create isolated temporary tmux sockets, Herdr configuration/server state and Zellij runtime/cache directories. They exercise actual lifecycle commands, tree parsing, hostile literal labels, pane splitting, focus and zoom, and (Zellij) the pane list, a pane rename, a divider move read back as the pane's width, a pane close, a session rename and a session close. They never target a pre-existing user multiplexer. Vitest checks session/pane identity and action/error behavior through the actual React panels.

The client workspace handles saved tmux, Herdr and Zellij attachment intents separately from these controls. Reconnect and restore reattach a saved Zellij session with `zellij attach <name>` and never `--create`: they first confirm the name is among `zellij list-sessions --short`, so a session that no longer exists (a host restart, a kill) fails with the multiplexer-unavailable message instead of starting an empty one. Attaching from **Sessions** still creates a new session. `ssh::tmux_jump_fixture::real_zellij_default_entry_creates_exact_target_and_keeps_child_after_bootstrap` runs this over owned OpenSSH with the pinned Zellij 0.45.1 in `native-linux-runtimes`: the second entry reattaches the same server and shell, and a reattach after the session is killed fails and leaves no session behind. Native device lifecycle, network-loss/reconnect and durable-process survival still require device acceptance under issue #7. Trees currently refresh explicitly.


### A Windows client against a Linux host

The real-runtime cases above start their OpenSSH server and multiplexers on the machine that runs the test, and the windows-latest runner has neither a Linux host nor the Linux multiplexer binaries. The `native-windows-linux-host` job provides the host inside the runner instead: an Ubuntu 24.04 WSL 2 distribution (the `Vampire/setup-wsl` action, pinned by commit) with `openssh-server`, Ubuntu's tmux 3.4, the checksum-verified Zellij 0.45.1 release and the same-run stock Herdr. `.github/scripts/external-linux-host.sh` starts an unprivileged `sshd` on `127.0.0.1:2222` with an isolated `HOME`, Zellij and Herdr configuration that skips their first-run screens, `SHELL=/bin/sh`, and a Herdr server named `ext-default` with one workspace labelled `EXT_DEFAULT`. WSL 2 forwards that loopback listener to the Windows loopback, and the Rust client under test runs natively on Windows and reaches it as `127.0.0.1:2222`. The job sets `LAZYSH_TEST_EXTERNAL_SSH_PORT`, `_USER`, `_FINGERPRINT` and `_KEY` (and optionally `_HOST`) from the script's output and runs four `#[ignore]` cases in `ssh::tests::external_host_fixture`, one at a time:

| Case | What it drives from the client |
| --- | --- |
| `external_host_discovery_reports_each_multiplexer_version_and_support` | `multiplexer_tree` reports tmux, Zellij and Herdr with the version each binary prints on the host and `support: full` |
| `external_host_tmux_creates_splits_attaches_and_detaches_without_running_names` | create a session whose name holds quotes, `;` and `$(touch nope)` (nothing is run), split, zoom, new window, rename, read the tree, attach, type into the pane and see the shell's answer, detach and see no client left |
| `external_host_zellij_creates_attaches_and_manages_tabs` | attach with create-if-missing, type and see the answer, list sessions, new tab, rename and close it by its id |
| `external_host_herdr_lists_attaches_and_reads_the_workspace_tree` | list the sessions, attach and see the workspace label, read the tree, create and rename a workspace |

Limits, so a green job is read for what it proves. The host is Linux in a VM on the same machine, reached over loopback: it proves the Windows client (russh transport, product command strings, process and terminal handling) against real multiplexer behaviour, not a Windows network path or a remote host. The Windows GUI and Mosh are not exercised, and a Windows OpenSSH host stays out of scope (discovery reports `unsupported_host_shell`). The owned Linux fixtures that start local processes (the tmux Jump To control-mode cases, the guarded Herdr and Mosh cases, `test:multiplexers`) are Unix-only and do not run here, so Jump To, confirmed input and the guarded Herdr binding have no Windows verification. WSL 1 also works on the runner but emulates the kernel, so the job uses WSL 2. The job runs on pushes to `main` only, like the other Windows and macOS jobs, and is non-blocking (`continue-on-error`) until its first pass on `main` is recorded on [#1747](https://github.com/mihazs/lazysh/issues/1747). The four cases passed on a hosted windows-latest run of the same host and composite action (run 43770703756, 2026-11-15, about 26 minutes with a cold Rust build); the Herdr executable there was the unverified artifact of an earlier `main` run, so the same-run Herdr verification steps in `checks.yml` have not yet run on Windows.

To run the same cases on Linux or macOS, start the host and point the cases at it (the script needs `sshd`, `ssh-keygen` and tmux on `PATH`; Zellij and Herdr are configured only when found, and `LAZYSH_HOST_PATH` puts a private tool directory first on the host's `PATH`):

```sh
.github/scripts/external-linux-host.sh /tmp/lazysh-host 2222 /tmp/lazysh-host-share
LAZYSH_TEST_EXTERNAL_SSH_PORT=2222 \
  LAZYSH_TEST_EXTERNAL_SSH_USER=$(cat /tmp/lazysh-host-share/user) \
  LAZYSH_TEST_EXTERNAL_SSH_FINGERPRINT=$(cat /tmp/lazysh-host-share/fingerprint) \
  LAZYSH_TEST_EXTERNAL_SSH_KEY=/tmp/lazysh-host-share/key \
  LAZYSH_EXPECT_MUX_SUPPORT='tmux=full zellij=full herdr=full' \
  cargo test --manifest-path apps/client/src-tauri/Cargo.toml --locked --lib ssh::tests::external_host_fixture:: -- --ignored --test-threads=1
kill "$(cat /tmp/lazysh-host/sshd.pid)"
```

The cases use the host's default tmux server and the sessions `ext-zellij` and `ext-default`, so point them only at a throwaway host. Stop its Herdr server (`herdr --session ext-default server stop`, run with the same environment) when you are done.

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

The same fixture accepts the managed backend. `real_ssh_managed_herdr_runs_every_native_call_and_never_the_system_one`
(`LAZYSH_TEST_HERDR_STOCK`) puts a Herdr at the managed path and leaves a failing decoy where the host's own Herdr
would be. After the connection captures the managed Herdr it checks discovery, the session list, the tree, an action and an
attachment, that a different second choice is refused and that the decoy never ran; then, on a host with no managed file,
that Herdr reads as absent, every call fails and the decoy still never runs.
`real_ssh_managed_guarded_herdr_binds_the_display_through_the_managed_executable` (`LAZYSH_TEST_HERDR`) does the same with a
guarded build and checks the guard probe and the bound display. The Herdr at the managed path is a stock or guarded debug
build, not a `lazysh-managed` release build, and Mosh startup was checked only through composed commands: namespace isolation next
to a stock server and the exact release artifact are the acceptance of #1761.

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

This case covers process death and GUI relaunch on Linux. It does not cover Herdr, Android process death, OS-vault prompts or network changes. The mocked Playwright case `e2e/workspace-relaunch.spec.ts` checks the restore order for tmux, Herdr, Zellij and plain-shell descriptors in both projects, including that Zellij restores with `createIfMissing:false`; a Zellij variant of this native case is still open (#1145).
