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
| Herdr | `herdr --version`; API `schema_version` not yet checked → [#1159](https://github.com/mihazs/lazysh/issues/1159) | 0.9.3–0.9.5 | other versions: navigation only | 0.9.3, moving to 0.9.5 in [#1117](https://github.com/mihazs/lazysh/issues/1117) |
| rmux | `rmux capabilities --json` (not `-V`, which prints rmux branding) | 0.10.x, wire 8 | wire mismatch: unsupported until the daemon restarts | 0.10.0 release tarball, sha256 `1bec11ef…c2696c5` |

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
pane. A notification opens that exact pane.

## Capability table: remote hosts

The multiplexer runs on a POSIX SSH or Mosh host (Linux or macOS). The client is
Android, Linux or Windows; differences between clients are in the next table.
Cells read **now → target (issue)**. *yes* means verified in CI, *impl* means
implemented without full evidence, *part* means partial.

| Capability | tmux | Zellij | Herdr | rmux |
| --- | --- | --- | --- | --- |
| Discovery | yes | impl → yes #1145 | yes | no → #1140 |
| Attach, reattach | yes | yes | yes | no → #1140 |
| Navigation, Jump To, current marker | yes; pane rows → #1146 | numbered tabs only → #1145 | yes; marker assertion #990 | no → #1140 |
| Create in a directory | yes | part → #1141 | yes | no → #1140 |
| Create in a worktree | no → #1141 | no → #1141 | yes | no → #1141 |
| Agent launch | no → #1141 | no → #1141 | yes | no → #1141 |
| Rename | session, window; pane → #1144 | no → #1144 | workspace, tab; pane → #1144 | no → #1140, #1144 |
| Close | no → #1144 | no → #1144 | no → #1144 | no → #1144 |
| Split, zoom | yes | yes | yes | no → #1140 |
| Resize | no → #1144 | no → #1144 | no → #1144 | no → #1144 |
| History | prefix+[ only → #1147 | no → #1147 | no → #1147 | no → #1147 |
| OSC 52 | user config, untested → #1147 | untested → #1147 | untested → #1147 | no → #1147 |
| Confirmed input | yes | no → #1145 | guarded yes; stock #655 | no → #1140 |
| Agent state | companion hooks | hooks, no pane link → #1146 | native | no → #1146 |
| Notification opens the pane | part → #1146 | no → #1146 | part → #1146 | no → #1146 |
| Restore | desktop yes; Android #988 | skipped → #1145 | impl → #990, #988 | no → #1140 (while the daemon lives) |
| Version detection | yes | yes | version yes; API schema → #1159 | no → #1140 |

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
