# Multiplexer compatibility

Status: specification. Tracked by the epic
[#1138](https://github.com/mihazs/lazysh/issues/1138) and its slice issues #1139–#1141
and #1144–#1149 on the [GitHub Project](https://github.com/users/mihazs/projects/2). Nothing here is
released until the slice that implements it ships. Today's behaviour is described in
[Durable workspaces](multiplexers.md).

lazysh supports four host-side multiplexers: **tmux**, **Zellij**, **Herdr** and
**rmux**. "Full compatibility" means every multiplexer is measured against the same
capability checklist below. A capability is either verified by a test, or shown
to the user as unavailable with a reason. Nothing fails silently.

## Co-existence contract

The rule from [Agent view](agent-view.md) applies to every multiplexer: the agent runs
in its real multiplexer pane, the terminal and the Agent view are two views of that
same session, and the user chooses which one to see. Terminal is the default. A
multiplexer slice is not complete until the **Terminal | Agent** switch works on its
sessions without reconnecting, detaching or replaying input.

## Capability checklist

| Capability | Definition |
| --- | --- |
| Discovery | List sessions or workspaces on the host without starting a server or daemon. |
| Attach and reattach | Open a session in a terminal tab; reattach after a dropped connection. |
| Navigation | Move between sessions/workspaces, windows/tabs and panes. Jump To shows the tree with exactly one current marker. |
| Create | New session/workspace, window/tab and pane in a chosen directory or a new Git worktree. |
| Agent launch | Start an agent's argv in a new window, tab or pane, for the launcher [#1128](https://github.com/mihazs/lazysh/issues/1128). |
| Layout actions | Rename, close (confirmed, by exact id), split, zoom and resize. |
| History and clipboard | Durable scrollback read from the multiplexer; OSC 52 copy reaches the client clipboard. |
| Confirmed input | The Agent view's ordered input path into the exact pane. |
| Agent state and notifications | Per-pane state where the multiplexer or the companion reports it; a notification opens the exact pane. |
| Restore | Reattach the same target after reconnect and after the app is killed and relaunched. |
| Version detection | Read the version, compare it with the supported range, and gate capabilities on it. |
| Graceful degradation | A missing or unsupported capability is hidden and listed with its reason. |

## What the four multiplexers are

- **tmux**, **Zellij** and **Herdr** are integrated today (see
  [Durable workspaces](multiplexers.md)) at different depths.
- **rmux** ([Helvesec/rmux](https://github.com/Helvesec/rmux), MIT OR Apache-2.0) is a
  Rust reimplementation of tmux. It keeps tmux's flags (`-u`, `-L`, `-S`, `-N`, `-C`),
  targets, format variables and control-mode lines, and runs natively on Linux, macOS
  and Windows. Its daemon keeps state in memory and exits when it has no sessions.

## Architecture

### Kinds and the extension point

`MultiplexerKind` stays an enum with exhaustive `match`es (`multiplexer.rs`, `ssh.rs`,
`mosh.rs`, `desktop_launch.rs`), so the compiler lists every site a new kind must
reach. No trait is added. The enum becomes `{ Tmux, Rmux, Zellij, Herdr }`.

### Capability record and version gate (#1139)

Discovery also prints each tool's version. `MultiplexerTree` gains, next to today's
booleans:

```json
{ "tools": [ { "kind": "tmux", "version": "3.2a", "support": "degraded",
               "missing": ["jump", "confirmedInput"] } ] }
```

One Rust table maps `(kind, version)` to capabilities. The frontend reads that record
(and `isTmuxFamily(kind)`) instead of the scattered `kind === 'tmux'` checks in
`App.tsx`, `MultiplexerPanel.tsx`, `workspace.ts`, `TerminalPane.tsx`,
`multiplexerGestures.ts`, `MultiplexerShortcuts.tsx` and `ChatTerminalInput.tsx`.

| Multiplexer | Version source | Full | Degraded | CI pins |
| --- | --- | --- | --- | --- |
| tmux | `tmux -V` | ≥ 3.4 | 3.2a–3.3: no Jump To or confirmed input | 3.2a (distribution), 3.4 (distribution and source) and 3.8, the newest release, built from source with sha256 |
| Zellij | `zellij --version` | 0.45.1 | 0.44.x until verified: no tree, close, resize or run | 0.45.1 static musl asset with sha256 |
| Herdr | `herdr --version` and `herdr api schema` (`schema_version`, read in discovery) | 0.9.3–0.9.5 with schema 1 (an unreadable schema keeps the version verdict) | other versions, or a readable schema other than 1: navigation only | 0.9.3, moving to 0.9.5 in [#1117](https://github.com/mihazs/lazysh/issues/1117) |
| rmux | `rmux capabilities --json` (not `-V`, which prints rmux branding) | 0.10.x, wire 8 | wire mismatch: unsupported until the daemon restarts | 0.10.0 release tarball, sha256 `1bec11ef…c2696c5` |

#### Herdr API schema (#1159)

The socket's `ping` reply carries `version`, `protocol` and `capabilities` but no
`schema_version`; the schema version is printed by `herdr api schema`, which prints the
installed binary's embedded schema and never contacts or starts a server. Discovery runs
it after `herdr --version`, so the result does not depend on whether a server is running.
A readable `schema_version` other than 1 degrades Herdr to navigation only, whatever its
version string, and the host's tool record carries `schemaVersion`. The Sessions panel
then says which schema the host reported. An unreadable schema (the command fails or
prints no number) keeps the version verdict, so a host is never downgraded for a probe
that did not answer. CI proves both directions on the same-run stock Herdr: it reports
`full` with `schemaVersion` 1 over real OpenSSH, and the discovery script reports
`degraded` when a wrapper changes only the schema number the real binary prints.

### rmux as a tmux-family binary (#1140)

Every tmux command is built from `TmuxServer::prefix()` (`tmux -u -L <name>`).
`TmuxServer` gains its binary, so `prefix()` yields `rmux -u -L <label>` for rmux and
the whole tmux stack is reused: discovery, attach, tree, Jump To control client and
its clean detach, numbered windows, prefix keys, actions, confirmed input, receipts,
Mosh entry, restore and desktop launch. Discovery probes with `-N` so it never starts
a daemon. lazysh always calls `rmux` by name, never a tmux shim, and tells rmux panes
from tmux panes by `RMUX_PANE` (rmux panes also export `TMUX` and `TMUX_PANE`).
rmux's SDK and bincode wire protocol are not used.

### Launch primitive (#1141)

`herdr_create`'s confirmed plan (agent check with `command -v`, optional
`git worktree add`, create, start) becomes multiplexer-neutral, with the same agent
table and literal argv quoting:

| Multiplexer | Start an agent |
| --- | --- |
| tmux, rmux | `new-window -d -P -F '#{pane_id}' -t =<session> -n <label> -c <dir> -- <argv>` |
| Zellij | `zellij --session <S> run --cwd <dir> --name <label> -- <argv>` (returns the pane id) |
| Herdr | unchanged: workspace or tab, then `agent start --pane` |

### Settings compatibility

`DefaultMultiplexer` rejects unknown kinds today, so a released client would fail to
import a synced host whose default is rmux. #1139 makes the reader tolerant
(an unknown kind imports as no default, with a note) and writes new kinds to a
separate optional host field that released clients ignore. Saved workspaces already
drop unknown kinds on restore.

### Pane identity (#1146)

Companion events carry a typed pane identity: tmux server label plus `TMUX_PANE`;
rmux label plus `RMUX_PANE`; `ZELLIJ_SESSION_NAME` plus `ZELLIJ_PANE_ID`; the Herdr
pane. A notification opens that exact pane. A terminal without a multiplexer that lazysh
started reports `lazysh:<id>` from `LAZYSH_TERMINAL` instead ([Agent view](agent-view.md#terminals-lazysh-starts)).

Shipped so far: the companion records `paneServer` (`tmux:<label>` or `rmux:<label>`, from the
socket path in `TMUX` or `RMUX`) next to `paneId`, and the Agents panel's report details show
it. A pane is rmux only when `RMUX_PANE` and `RMUX` equal `TMUX_PANE` and `TMUX`, so a tmux started
inside an rmux pane stays tmux. Zellij and Herdr panes already carry their session in `paneId`.
A `-S` socket has no label and records none. Lifecycle hooks run inside Herdr record `herdr:<session>:<pane id>`
(a tmux or Zellij pane started inside it keeps its own identity).

Shipped for the tap focus (#1690): a notification tap, an inbox row and **Open session** focus
the pane of an event whose pane is `zellij:<session>:<pane>`, only when the terminal is
attached to that Zellij session. `zellij action focus-pane-id` cannot do it: from the command
line it moves the focus of the command's own client, not the attached terminal's (measured on
0.46.0), so the app reads the pane's tab (`list-panes --json`), goes to it (`go-to-tab`) and
steps `focus-next-pane` until `list-clients` reports the pane. A pane of another session, or of
another multiplexer, is left alone rather than guessed, and a pane that has gone still opens
the session. The same tap focuses a tmux or rmux `%N` only when the terminal is attached to the
server the event's `paneServer` names (a pane of another attached server is refused; a report
with no `paneServer` is looked up on the attached server, as before), and a `herdr:<session>:<pane id>`
pane through `herdr_tree` and `herdr_action` when the terminal is attached to that Herdr server.
The Agent view, the status bar's current-pane agent, the Agent view's reported-state guard and Jump To pane
rows ignore a report whose `paneServer` is another server than the attached one. A Herdr pane on
a server the terminal is not attached to is left alone rather than attached on a tap.

## Capability table: remote hosts

The multiplexer runs on a POSIX SSH or Mosh host (Linux or macOS). The client is
Android, Linux or Windows; differences between clients are in the next table.
Cells read **now → target (issue)**. *yes* means verified in CI, *impl* means
implemented without full evidence, *part* means partial.

| Capability | tmux | Zellij | Herdr | rmux |
| --- | --- | --- | --- | --- |
| Discovery | yes | impl → yes #1145 | yes | yes |
| Attach, reattach | yes | yes (reattach never creates and refuses an exited session, #1145, #2047) | yes | attach yes; reattach → #1677 |
| Navigation, Jump To, current marker | yes, with pane rows (#1691) | impl (tab Jump To; a current row only while one client is attached, #2046); Android evidence → #1145 | yes; marker assertion #990 | tree and window and pane actions yes; Jump To → #1675 |
| Create in a directory | yes | part → #1141 | yes | yes |
| Create in a worktree | impl, backend only → #1128, #1680 | impl, backend only → #1128, #1680 | yes | no → #1679 |
| Agent launch | impl, backend only → #1128, #1680 | impl, backend only → #1128, #1680 | yes | no → #1679 |
| Rename | session, window, pane | tab yes; session, pane impl → yes #1685 | workspace, tab, pane | session, window, pane |
| Close | session, window (tab strip), pane | tab yes; pane, session impl → yes #1685 | workspace, tab (#1573), pane | session, window, pane |
| Split, zoom | yes | yes | yes | yes |
| Resize | yes | impl → yes #1685 | yes | yes |
| History | yes | yes | part: Herdr serves the newest 1000 lines | no → #1700, #1140 |
| OSC 52 | impl; `set-clipboard` documented → yes #1699 | impl; default → yes #1699 | impl; default over SSH → yes #1699 | no → #1147 |
| Confirmed input | yes | no → #1145 | guarded yes; stock #655 | no → #1140 |
| Agent state | companion hooks | hooks, no pane link → #1146 | native | no → #1146 |
| Notification opens the pane | part → #1146 | part: the attached session's pane #1690 | part → #1146 | no → #1146 |
| Restore | desktop yes; Android #988 | impl (live session only; GUI and Android evidence → #1145) | impl → #990, #988 | impl → #1677 (while the daemon lives) |
| Version detection | yes | yes | yes, version and API schema | yes (Limited until #1675) |

Restore after a host reboot is not offered for rmux (in-memory daemon) or Zellij;
lazysh offers to recreate the session instead.

## Capability table: client platforms and local sessions

| Multiplexer | Android (remote) | Linux remote | Linux local | Windows remote | Windows local |
| --- | --- | --- | --- | --- | --- |
| tmux | yes | yes | #1131 | yes; CI evidence → #1149 | n/a natively: no Windows tmux; WSL target in #1129 |
| Zellij | no → #1145 | yes | #1131 | yes; CI → #1149 | native ≥ 0.44 → #1131 |
| Herdr | yes | yes | #1131 | yes; CI → #1149 | native ≥ 0.8.2 → #1131 |
| rmux | → #1140 | → #1140 | → #1148 | → #1140 | native → #1148 |

Windows OpenSSH **hosts** (cmd or PowerShell login shell) are out of scope: discovery
returns an explicit `unsupported_host_shell` error (#1139). rmux on a Windows machine
is reached through local sessions only, because its named pipe is bound to the
desktop logon's user and integrity level. macOS clients follow Linux.

## UX

- The Sessions panel lists each detected multiplexer with its version and a badge:
  **Supported**, **Limited** (with the missing capabilities and the version that adds
  them) or **Unsupported** (with the reason, for example "Restart the rmux daemon
  after upgrading").
- Actions the capability record does not allow are not shown. Nothing is shown and
  then fails.
- Every multiplexer gets the same Jump To layouts (list, accordion, grid) with one
  `aria-current` row, and the same create, rename, close and resize actions.
- Close always asks for confirmation naming the session, window, tab or pane.
- The launcher (#1128) offers the session's multiplexer and shows the full plan
  (directory or worktree, agent, target) before running it.
- Phone and desktop get the same features; Android reaches every multiplexer through
  its host.

## Security

- No arbitrary socket paths. tmux and rmux use validated `-L` labels.
- Every name, directory, prompt and agent argument reaches the host as one quoted
  literal word. Tests use names with spaces, quotes, `$(…)`, newlines and a trailing
  `;`.
- Discovery never starts a server or daemon (`rmux -N`).
- Close actions target exact ids and need confirmation. Hook, event and protocol
  data set state only; they never trigger input.
- Binaries downloaded or built in CI are pinned by exact version and sha256 (or
  registry integrity hash) and installed into temporary prefixes.

## Test strategy

Tests assert behaviour, not source text. Each slice lists its tests; together they
cover:

- **Real runtimes** (`native-linux-runtimes`, `test:multiplexers` and `test:tmux`):
  one lifecycle test per multiplexer over owned OpenSSH that drives product discovery,
  attach, the parsed tree, each action, agent launch with a stub agent and literal
  hostile names. The tmux Jump fixtures run against both tmux and rmux.
- **Version matrix**: tmux 3.2a (degraded), 3.4 and the newest release; Zellij
  0.45.1; Herdr 0.9.3/0.9.5; rmux 0.10.0.
- **Unit tests on Linux and windows-latest** (`native-desktop`): version parsing,
  capability gates, command and argv building, tree and event parsing.
- **Windows local** (#1148): pinned native rmux through ConPTY on windows-latest.
- **Windows client against a Linux host** (#1747, `native-windows-linux-host`): a WSL 2 Ubuntu host on windows-latest with an unprivileged OpenSSH server, tmux, Zellij and Herdr; discovery, attach, tree and actions run from the Rust client natively on Windows ([how](multiplexers.md#a-windows-client-against-a-linux-host)).
- **Playwright phone (390×844) and desktop (1280×800)**: badges, notices, Jump To,
  confirmations and launcher plans against a mocked bridge.
- **Linux native GUI** (`apps/client/native-e2e`): attach, Jump To, restore and the
  Terminal | Agent switch per multiplexer.
- **Android** (`NativeWorkspaceTest`): rmux and Zellij attach and jump;
  tmux and Herdr actions.
- Every result lands in the [parity matrix](reference/parity-matrix.md) under tmux,
  Zellij, Herdr and rmux (#1149).

## Out of scope

- rmux's SDK and bincode wire protocol; tmux shims (`rmux setup tmux-shim`).
- Windows OpenSSH hosts with a non-POSIX login shell.
- Restoring sessions after a host reboot, and tmux resurrect-style plugins.
- Multiplexers other than these four. cmux is out of scope because it is macOS-only.
